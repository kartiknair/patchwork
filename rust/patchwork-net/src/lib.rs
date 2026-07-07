pub mod clock;
pub mod color;
pub mod protocol;
pub mod state;

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use matchbox_socket::{ChannelConfig, PeerId, PeerState, RtcIceServerConfig, WebRtcSocket};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use clock::wall_clock_ms;
use protocol::{Cursor, ParamEntry, ParamField, ParamValue, WireMessage};
use state::RoomState;

const CHANNEL_RELIABLE: usize = 0;
const CHANNEL_UNRELIABLE: usize = 1;
const CHAT_LIFETIME_MS: u64 = 5000;

/// serde_wasm_bindgen serializes Rust HashMaps as JS `Map` instances by
/// default, not plain objects - which silently breaks `{...spread}` on the JS
/// side (Map has no own enumerable properties). Force plain-object output for
/// anything crossing the wasm boundary.
fn to_js<T: Serialize + ?Sized>(value: &T) -> JsValue {
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    value.serialize(&serializer).unwrap_or(JsValue::NULL)
}

#[derive(Deserialize)]
struct IceServerDto {
    urls: Vec<String>,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    credential: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum Event {
    Connected { self_peer_id: String },
    Disconnected,
    PeerJoined { peer_id: String, name: String, color: String },
    PeerLeft { peer_id: String },
    PresenceChanged { peers: Vec<PeerPresenceJson> },
    ParamsChanged { params: HashMap<&'static str, ParamJsonValue> },
    Error { message: String },
}

#[derive(Serialize)]
struct PeerPresenceJson {
    peer_id: String,
    name: String,
    color: String,
    cursor: Option<Cursor>,
    chat: Option<String>,
    active_control: Option<String>,
    active_notes: Vec<String>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum ParamJsonValue {
    Num(f64),
    Str(String),
}

impl From<&ParamValue> for ParamJsonValue {
    fn from(v: &ParamValue) -> Self {
        match v {
            ParamValue::Num(n) => ParamJsonValue::Num(*n),
            ParamValue::Str(s) => ParamJsonValue::Str(s.clone()),
        }
    }
}

struct Inner {
    socket: WebRtcSocket,
    room: RoomState,
    name: String,
    color: String,
    self_peer_id: Option<String>,
    events: Vec<Event>,
}

impl Inner {
    fn params_json(&self) -> HashMap<&'static str, ParamJsonValue> {
        ParamField::ALL
            .into_iter()
            .map(|f| (f.as_key(), self.room.params.get(f).into()))
            .collect()
    }

    fn peers_json(&self) -> Vec<PeerPresenceJson> {
        self.room
            .presences
            .iter()
            .map(|(id, p)| PeerPresenceJson {
                peer_id: id.clone(),
                name: p.name.clone(),
                color: p.color.clone(),
                cursor: p.cursor.clone(),
                chat: p.chat.clone(),
                active_control: p.active_control.clone(),
                active_notes: p.active_notes.clone(),
            })
            .collect()
    }

    fn broadcast(&mut self, msg: &WireMessage, channel: usize) {
        let Ok(bytes) = postcard::to_allocvec(msg) else {
            return;
        };
        let packet: matchbox_socket::Packet = bytes.into_boxed_slice();
        let peers: Vec<PeerId> = self.socket.connected_peers().collect();
        for peer in peers {
            self.socket.channel_mut(channel).send(packet.clone(), peer);
        }
    }

    fn unicast(&mut self, msg: &WireMessage, channel: usize, peer: PeerId) {
        let Ok(bytes) = postcard::to_allocvec(msg) else {
            return;
        };
        let packet: matchbox_socket::Packet = bytes.into_boxed_slice();
        self.socket.channel_mut(channel).send(packet, peer);
    }

    /// Drains the socket's peer/message queues, merges incoming state, and
    /// appends any resulting `Event`s to `self.events`. Call once per rAF tick.
    fn pump(&mut self) {
        if self.self_peer_id.is_none() {
            if let Some(id) = self.socket.id() {
                let id_str = id.to_string();
                self.self_peer_id = Some(id_str.clone());
                self.room.self_peer_id = id_str.clone();
                self.events.push(Event::Connected { self_peer_id: id_str });
            }
        }

        // Set whenever any peer/self connection or presences entry changes,
        // regardless of whether the peer was already known, so PeerJoined/PeerLeft
        // are always accompanied by an up-to-date PresenceChanged in the same tick.
        let mut presence_dirty = false;

        for (peer_id, state) in self.socket.update_peers() {
            match state {
                PeerState::Connected => {
                    let hello = WireMessage::Hello {
                        name: self.name.clone(),
                        color: self.color.clone(),
                    };
                    self.unicast(&hello, CHANNEL_RELIABLE, peer_id);
                }
                PeerState::Disconnected => {
                    let key = peer_id.to_string();
                    if self.room.presences.remove(&key).is_some() {
                        self.events.push(Event::PeerLeft { peer_id: key });
                        presence_dirty = true;
                    }
                }
            }
        }

        let reliable_msgs = self.socket.channel_mut(CHANNEL_RELIABLE).receive();
        for (peer_id, packet) in reliable_msgs {
            let Ok(msg) = postcard::from_bytes::<WireMessage>(&packet) else {
                continue;
            };
            let key = peer_id.to_string();
            match msg {
                WireMessage::Hello { name, color } => {
                    let is_new = !self.room.presences.contains_key(&key);
                    let entry = self.room.presences.entry(key.clone()).or_default();
                    entry.name = name.clone();
                    entry.color = color.clone();
                    presence_dirty = true;
                    if is_new {
                        self.events.push(Event::PeerJoined { peer_id: key, name, color });
                        let snapshot = WireMessage::FullStateSnapshot {
                            params: self.room.params.entries(),
                            name: self.name.clone(),
                            color: self.color.clone(),
                        };
                        self.unicast(&snapshot, CHANNEL_RELIABLE, peer_id);
                    }
                }
                WireMessage::IdentityUpdate { name, color } => {
                    if let Some(p) = self.room.presences.get_mut(&key) {
                        p.name = name;
                        p.color = color;
                        presence_dirty = true;
                    }
                }
                WireMessage::ChatMessage { text, expires_at } => {
                    if let Some(p) = self.room.presences.get_mut(&key) {
                        p.chat = Some(text);
                        p.chat_expires_at = expires_at;
                        presence_dirty = true;
                    }
                }
                WireMessage::ActiveControl { label } => {
                    if let Some(p) = self.room.presences.get_mut(&key) {
                        p.active_control = label;
                        presence_dirty = true;
                    }
                }
                WireMessage::NoteOn { note } => {
                    if let Some(p) = self.room.presences.get_mut(&key) {
                        if !p.active_notes.contains(&note) {
                            p.active_notes.push(note);
                            presence_dirty = true;
                        }
                    }
                }
                WireMessage::NoteOff { note } => {
                    if let Some(p) = self.room.presences.get_mut(&key) {
                        let before = p.active_notes.len();
                        p.active_notes.retain(|n| *n != note);
                        if p.active_notes.len() != before {
                            presence_dirty = true;
                        }
                    }
                }
                WireMessage::ParamUpdate(entry) => {
                    if self.room.apply_param_entry(&entry) {
                        self.events.push(Event::ParamsChanged { params: self.params_json() });
                    }
                }
                WireMessage::FullStateSnapshot { params, name, color } => {
                    let is_new = !self.room.presences.contains_key(&key);
                    let entry = self.room.presences.entry(key.clone()).or_default();
                    entry.name = name.clone();
                    entry.color = color.clone();
                    presence_dirty = true;
                    if is_new {
                        self.events.push(Event::PeerJoined { peer_id: key, name, color });
                    }
                    if self.room.apply_snapshot(&params) {
                        self.events.push(Event::ParamsChanged { params: self.params_json() });
                    }
                }
                WireMessage::PresenceUpdate { .. } => {
                    // Only ever sent on the unreliable channel; ignore if seen here.
                }
            }
        }

        let unreliable_msgs = self.socket.channel_mut(CHANNEL_UNRELIABLE).receive();
        for (peer_id, packet) in unreliable_msgs {
            let Ok(WireMessage::PresenceUpdate { cursor }) =
                postcard::from_bytes::<WireMessage>(&packet)
            else {
                continue;
            };
            let key = peer_id.to_string();
            if let Some(p) = self.room.presences.get_mut(&key) {
                p.cursor = cursor;
                presence_dirty = true;
            }
        }

        let now = wall_clock_ms();
        for p in self.room.presences.values_mut() {
            if p.chat.is_some() && p.chat_expires_at <= now {
                p.chat = None;
                presence_dirty = true;
            }
        }

        if presence_dirty {
            self.events.push(Event::PresenceChanged { peers: self.peers_json() });
        }
    }
}

#[wasm_bindgen]
pub struct MatchboxRoom {
    inner: Rc<RefCell<Inner>>,
}

#[wasm_bindgen]
impl MatchboxRoom {
    /// `ice_servers_json` is an optional JSON array of `{urls, username?, credential?}`
    /// (matching `NEXT_PUBLIC_MATCHBOX_ICE_SERVERS`); only the first entry is used,
    /// since matchbox_socket configures a single ICE server per connection.
    #[wasm_bindgen(constructor)]
    pub fn new(
        signaling_url: String,
        room_id: String,
        name: String,
        color: String,
        ice_servers_json: Option<String>,
    ) -> MatchboxRoom {
        console_error_panic_hook::set_once();

        let room_url = format!("{}/{}", signaling_url.trim_end_matches('/'), room_id);
        let mut builder = WebRtcSocket::builder(room_url)
            .add_channel(ChannelConfig::reliable())
            .add_channel(ChannelConfig::unreliable());

        if let Some(json) = ice_servers_json {
            if let Ok(servers) = serde_json::from_str::<Vec<IceServerDto>>(&json) {
                if let Some(first) = servers.into_iter().next() {
                    builder = builder.ice_server(RtcIceServerConfig {
                        urls: first.urls,
                        username: first.username,
                        credential: first.credential,
                    });
                }
            }
        }

        let (socket, message_loop) = builder.build();

        let inner = Rc::new(RefCell::new(Inner {
            socket,
            room: RoomState::new(String::new()),
            name,
            color,
            self_peer_id: None,
            events: Vec::new(),
        }));

        {
            let inner = inner.clone();
            wasm_bindgen_futures::spawn_local(async move {
                if let Err(err) = message_loop.await {
                    inner.borrow_mut().events.push(Event::Error { message: err.to_string() });
                }
                inner.borrow_mut().events.push(Event::Disconnected);
            });
        }

        MatchboxRoom { inner }
    }

    /// Drains the socket, applies LWW merges, and returns a JS array of events.
    /// Call every `requestAnimationFrame`.
    pub fn tick(&mut self) -> JsValue {
        let mut inner = self.inner.borrow_mut();
        inner.pump();
        let events = std::mem::take(&mut inner.events);
        to_js(&events)
    }

    pub fn set_cursor(&mut self, x: f64, y: f64) {
        let mut inner = self.inner.borrow_mut();
        let msg = WireMessage::PresenceUpdate {
            cursor: Some(Cursor { x: x as f32, y: y as f32 }),
        };
        inner.broadcast(&msg, CHANNEL_UNRELIABLE);
    }

    pub fn clear_cursor(&mut self) {
        let mut inner = self.inner.borrow_mut();
        let msg = WireMessage::PresenceUpdate { cursor: None };
        inner.broadcast(&msg, CHANNEL_UNRELIABLE);
    }

    pub fn set_name(&mut self, name: String) {
        let mut inner = self.inner.borrow_mut();
        inner.name = name;
        let msg = WireMessage::IdentityUpdate {
            name: inner.name.clone(),
            color: inner.color.clone(),
        };
        inner.broadcast(&msg, CHANNEL_RELIABLE);
    }

    pub fn set_color(&mut self, color: String) {
        let mut inner = self.inner.borrow_mut();
        inner.color = color;
        let msg = WireMessage::IdentityUpdate {
            name: inner.name.clone(),
            color: inner.color.clone(),
        };
        inner.broadcast(&msg, CHANNEL_RELIABLE);
    }

    pub fn set_active_control(&mut self, label: Option<String>) {
        let mut inner = self.inner.borrow_mut();
        let msg = WireMessage::ActiveControl { label };
        inner.broadcast(&msg, CHANNEL_RELIABLE);
    }

    pub fn note_on(&mut self, note: String) {
        let mut inner = self.inner.borrow_mut();
        inner.broadcast(&WireMessage::NoteOn { note }, CHANNEL_RELIABLE);
    }

    pub fn note_off(&mut self, note: String) {
        let mut inner = self.inner.borrow_mut();
        inner.broadcast(&WireMessage::NoteOff { note }, CHANNEL_RELIABLE);
    }

    pub fn send_chat(&mut self, text: String) {
        let mut inner = self.inner.borrow_mut();
        let expires_at = wall_clock_ms() + CHAT_LIFETIME_MS;
        let msg = WireMessage::ChatMessage { text, expires_at };
        inner.broadcast(&msg, CHANNEL_RELIABLE);
    }

    /// `value` must be a number for numeric fields, or a string for
    /// `waveform`/`lfoTarget`. Unknown field names or mismatched value types
    /// are silently ignored.
    pub fn set_param(&mut self, field: &str, value: JsValue) {
        let mut inner = self.inner.borrow_mut();
        let Some(field) = ParamField::from_key(field) else {
            return;
        };
        let value = if field.is_string_valued() {
            match value.as_string() {
                Some(s) => ParamValue::Str(s),
                None => return,
            }
        } else {
            match value.as_f64() {
                Some(n) => ParamValue::Num(n),
                None => return,
            }
        };

        let now = wall_clock_ms();
        let ts = inner.room.next_local_ts(now);
        let writer = inner.room.self_peer_id.clone();
        inner.room.params.apply(field, value.clone(), ts, &writer);

        let entry = ParamEntry { field, value, timestamp: ts, writer };
        inner.broadcast(&WireMessage::ParamUpdate(entry), CHANNEL_RELIABLE);
    }

    pub fn snapshot_params(&self) -> JsValue {
        let inner = self.inner.borrow();
        to_js(&inner.params_json())
    }

    pub fn self_peer_id(&self) -> String {
        self.inner.borrow().self_peer_id.clone().unwrap_or_default()
    }

    pub fn peer_count(&self) -> usize {
        self.inner.borrow().room.presences.len()
    }

    pub fn disconnect(self) {
        self.inner.borrow_mut().socket.close();
    }
}
