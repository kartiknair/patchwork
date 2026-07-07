use std::collections::HashMap;

use crate::protocol::{Cursor, ParamEntry, ParamField, ParamValue};

#[derive(Clone, Debug, PartialEq)]
pub struct FieldState {
    pub value: ParamValue,
    pub timestamp: u64,
    pub writer: String,
}

/// Mirrors app/synth.tsx's DEFAULT_PARAMS.
fn default_value(field: ParamField) -> ParamValue {
    match field {
        ParamField::Waveform => ParamValue::Str("sawtooth".into()),
        ParamField::FilterCutoff => ParamValue::Num(2000.0),
        ParamField::FilterRes => ParamValue::Num(1.0),
        ParamField::Volume => ParamValue::Num(0.7),
        ParamField::AmpA => ParamValue::Num(0.01),
        ParamField::AmpD => ParamValue::Num(0.2),
        ParamField::AmpS => ParamValue::Num(0.7),
        ParamField::AmpR => ParamValue::Num(0.3),
        ParamField::FiltA => ParamValue::Num(0.01),
        ParamField::FiltD => ParamValue::Num(0.3),
        ParamField::FiltS => ParamValue::Num(0.5),
        ParamField::FiltR => ParamValue::Num(0.5),
        ParamField::FiltEnvAmt => ParamValue::Num(3000.0),
        ParamField::LfoRate => ParamValue::Num(5.0),
        ParamField::LfoDepth => ParamValue::Num(20.0),
        ParamField::LfoTarget => ParamValue::Str("none".into()),
        ParamField::Octave => ParamValue::Num(4.0),
    }
}

pub struct SynthParamsState {
    fields: HashMap<ParamField, FieldState>,
}

impl Default for SynthParamsState {
    fn default() -> Self {
        let fields = ParamField::ALL
            .into_iter()
            .map(|f| {
                (
                    f,
                    FieldState {
                        value: default_value(f),
                        timestamp: 0,
                        writer: String::new(),
                    },
                )
            })
            .collect();
        SynthParamsState { fields }
    }
}

impl SynthParamsState {
    /// Applies an incoming write, keeping the field's current value if the
    /// incoming write does not win the (timestamp, writer) comparison. Same
    /// comparator run on every peer regardless of arrival order guarantees
    /// convergence. Returns true if the incoming value changed the field.
    pub fn apply(&mut self, field: ParamField, value: ParamValue, timestamp: u64, writer: &str) -> bool {
        let slot = self
            .fields
            .get_mut(&field)
            .expect("ParamField::ALL covers every field, entry always present");
        let wins = (timestamp, writer) > (slot.timestamp, slot.writer.as_str());
        if wins && slot.value != value {
            slot.value = value;
            slot.timestamp = timestamp;
            slot.writer = writer.to_string();
            true
        } else if wins {
            slot.timestamp = timestamp;
            slot.writer = writer.to_string();
            false
        } else {
            false
        }
    }

    pub fn get(&self, field: ParamField) -> &ParamValue {
        &self.fields[&field].value
    }

    pub fn entries(&self) -> Vec<ParamEntry> {
        ParamField::ALL
            .into_iter()
            .map(|field| {
                let slot = &self.fields[&field];
                ParamEntry {
                    field,
                    value: slot.value.clone(),
                    timestamp: slot.timestamp,
                    writer: slot.writer.clone(),
                }
            })
            .collect()
    }
}

#[derive(Clone, Debug, Default)]
pub struct PresenceState {
    pub name: String,
    pub color: String,
    pub cursor: Option<Cursor>,
    pub chat: Option<String>,
    pub chat_expires_at: u64,
    pub active_control: Option<String>,
    pub active_notes: Vec<String>,
}

pub struct RoomState {
    pub self_peer_id: String,
    pub params: SynthParamsState,
    pub presences: HashMap<String, PresenceState>,
    logical_clock: u64,
}

impl RoomState {
    pub fn new(self_peer_id: String) -> Self {
        RoomState {
            self_peer_id,
            params: SynthParamsState::default(),
            presences: HashMap::new(),
            logical_clock: 0,
        }
    }

    /// Hybrid-logical-clock-lite: guarantees any locally generated timestamp is
    /// strictly greater than every remote timestamp observed so far, even if the
    /// local wall clock is behind a peer's. Prevents a peer with a slow OS clock
    /// from having edits permanently lose to earlier-but-fresher timestamps.
    pub fn next_local_ts(&mut self, wall_clock_ms: u64) -> u64 {
        self.logical_clock = self.logical_clock.max(wall_clock_ms) + 1;
        self.logical_clock
    }

    pub fn observe_remote_ts(&mut self, ts: u64) {
        self.logical_clock = self.logical_clock.max(ts);
    }

    pub fn apply_param_entry(&mut self, entry: &ParamEntry) -> bool {
        self.observe_remote_ts(entry.timestamp);
        self.params
            .apply(entry.field, entry.value.clone(), entry.timestamp, &entry.writer)
    }

    pub fn apply_snapshot(&mut self, entries: &[ParamEntry]) -> bool {
        let mut changed = false;
        for entry in entries {
            if self.apply_param_entry(entry) {
                changed = true;
            }
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn out_of_order_delivery_converges() {
        let mut a = SynthParamsState::default();
        let mut b = SynthParamsState::default();

        // a receives (ts=5) then (ts=10); b receives them in reverse order.
        a.apply(ParamField::Volume, ParamValue::Num(0.3), 5, "p1");
        a.apply(ParamField::Volume, ParamValue::Num(0.9), 10, "p2");

        b.apply(ParamField::Volume, ParamValue::Num(0.9), 10, "p2");
        b.apply(ParamField::Volume, ParamValue::Num(0.3), 5, "p1");

        assert_eq!(a.get(ParamField::Volume), b.get(ParamField::Volume));
        assert_eq!(*a.get(ParamField::Volume), ParamValue::Num(0.9));
    }

    #[test]
    fn equal_timestamps_tiebreak_by_writer() {
        let mut a = SynthParamsState::default();
        a.apply(ParamField::Octave, ParamValue::Num(3.0), 42, "peer-aaa");
        let applied = a.apply(ParamField::Octave, ParamValue::Num(5.0), 42, "peer-bbb");
        assert!(applied, "peer-bbb > peer-aaa lexicographically, should win the tie");
        assert_eq!(*a.get(ParamField::Octave), ParamValue::Num(5.0));

        let mut b = SynthParamsState::default();
        b.apply(ParamField::Octave, ParamValue::Num(5.0), 42, "peer-bbb");
        let applied = b.apply(ParamField::Octave, ParamValue::Num(3.0), 42, "peer-aaa");
        assert!(!applied, "peer-aaa < peer-bbb lexicographically, should lose the tie");
        assert_eq!(*b.get(ParamField::Octave), ParamValue::Num(5.0));
    }

    #[test]
    fn snapshot_merge_is_idempotent_under_duplicates() {
        let mut state = RoomState::new("self".into());
        let entry = ParamEntry {
            field: ParamField::FilterCutoff,
            value: ParamValue::Num(880.0),
            timestamp: 100,
            writer: "peer-1".into(),
        };
        let snapshot = vec![entry.clone(), entry.clone(), entry];

        let changed = state.apply_snapshot(&snapshot);
        assert!(changed);
        assert_eq!(*state.params.get(ParamField::FilterCutoff), ParamValue::Num(880.0));

        // Applying the identical snapshot again must not report a change and
        // must not corrupt state.
        let changed_again = state.apply_snapshot(&snapshot);
        assert!(!changed_again);
        assert_eq!(*state.params.get(ParamField::FilterCutoff), ParamValue::Num(880.0));
    }

    #[test]
    fn multiple_snapshots_from_different_peers_converge_regardless_of_order() {
        let early = ParamEntry {
            field: ParamField::LfoRate,
            value: ParamValue::Num(1.0),
            timestamp: 10,
            writer: "peer-a".into(),
        };
        let late = ParamEntry {
            value: ParamValue::Num(7.0),
            timestamp: 20,
            writer: "peer-b".into(),
            ..early.clone()
        };

        let mut state1 = RoomState::new("self".into());
        state1.apply_snapshot(&[early.clone(), late.clone()]);

        let mut state2 = RoomState::new("self".into());
        state2.apply_snapshot(&[late, early]);

        assert_eq!(
            state1.params.get(ParamField::LfoRate),
            state2.params.get(ParamField::LfoRate)
        );
        assert_eq!(*state1.params.get(ParamField::LfoRate), ParamValue::Num(7.0));
    }
}
