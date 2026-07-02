use serde::{Deserialize, Serialize};

/// Every field of `SynthParams` (see app/synth.tsx) that can be independently
/// last-write-wins merged.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ParamField {
    Waveform,
    FilterCutoff,
    FilterRes,
    Volume,
    AmpA,
    AmpD,
    AmpS,
    AmpR,
    FiltA,
    FiltD,
    FiltS,
    FiltR,
    FiltEnvAmt,
    LfoRate,
    LfoDepth,
    LfoTarget,
    Octave,
}

impl ParamField {
    pub const ALL: [ParamField; 17] = [
        ParamField::Waveform,
        ParamField::FilterCutoff,
        ParamField::FilterRes,
        ParamField::Volume,
        ParamField::AmpA,
        ParamField::AmpD,
        ParamField::AmpS,
        ParamField::AmpR,
        ParamField::FiltA,
        ParamField::FiltD,
        ParamField::FiltS,
        ParamField::FiltR,
        ParamField::FiltEnvAmt,
        ParamField::LfoRate,
        ParamField::LfoDepth,
        ParamField::LfoTarget,
        ParamField::Octave,
    ];

    /// Matches the exact camelCase key used in app/synth.tsx's SynthParams object,
    /// since the JS side dispatches by field name string.
    pub fn as_key(&self) -> &'static str {
        match self {
            ParamField::Waveform => "waveform",
            ParamField::FilterCutoff => "filterCutoff",
            ParamField::FilterRes => "filterRes",
            ParamField::Volume => "volume",
            ParamField::AmpA => "ampA",
            ParamField::AmpD => "ampD",
            ParamField::AmpS => "ampS",
            ParamField::AmpR => "ampR",
            ParamField::FiltA => "filtA",
            ParamField::FiltD => "filtD",
            ParamField::FiltS => "filtS",
            ParamField::FiltR => "filtR",
            ParamField::FiltEnvAmt => "filtEnvAmt",
            ParamField::LfoRate => "lfoRate",
            ParamField::LfoDepth => "lfoDepth",
            ParamField::LfoTarget => "lfoTarget",
            ParamField::Octave => "octave",
        }
    }

    pub fn from_key(key: &str) -> Option<ParamField> {
        ParamField::ALL.into_iter().find(|f| f.as_key() == key)
    }

    pub fn is_string_valued(&self) -> bool {
        matches!(self, ParamField::Waveform | ParamField::LfoTarget)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum ParamValue {
    Num(f64),
    Str(String),
}

impl ParamValue {
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            ParamValue::Num(n) => Some(*n),
            ParamValue::Str(_) => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            ParamValue::Str(s) => Some(s.as_str()),
            ParamValue::Num(_) => None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ParamEntry {
    pub field: ParamField,
    pub value: ParamValue,
    pub timestamp: u64,
    pub writer: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Cursor {
    pub x: f32,
    pub y: f32,
}

/// Sender identity is always the transport-level PeerId matchbox hands back
/// alongside each received packet, so message payloads don't repeat it -
/// except in `ParamEntry.writer`, which records the field's original author
/// and may differ from the immediate sender when a snapshot is relayed.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum WireMessage {
    /// Announced by a peer as soon as its socket connects to any other peer.
    /// Triggers the receiver to unicast back a `FullStateSnapshot`.
    Hello { name: String, color: String },
    /// High-frequency, sent on the unreliable/unordered channel.
    PresenceUpdate { cursor: Option<Cursor> },
    /// Sent on the reliable channel so name/color changes aren't dropped.
    IdentityUpdate { name: String, color: String },
    /// expires_at is the sender's local clock + 5000ms; every peer (including the
    /// sender) independently clears the bubble once its own clock passes it.
    ChatMessage { text: String, expires_at: u64 },
    ParamUpdate(ParamEntry),
    /// Unicast reply to a `Hello` from an unrecognized peer. Merging is
    /// idempotent/commutative (per-field LWW), so receiving several of these
    /// (e.g. one per existing peer) or duplicates is safe.
    FullStateSnapshot {
        params: Vec<ParamEntry>,
        name: String,
        color: String,
    },
}
