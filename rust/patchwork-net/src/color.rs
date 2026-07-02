pub const COLORS: [&str; 8] = [
    "#ff7ab8", "#7adfff", "#b8ff7a", "#ffd47a", "#ff8a72", "#c79bff", "#7ad3e0", "#82e6b0",
];

/// Deterministic peer_id -> color assignment. Liveblocks used a server-issued
/// sequential connection ID (`connectionId % 8`); a pure P2P mesh has no such
/// sequencer, so every peer computes the same color for a given peer_id via a
/// simple string hash instead. Cosmetic-only: with the room cap at 8 peers this
/// can occasionally collide, and there's already a manual color picker.
pub fn color_for_peer(peer_id: &str) -> &'static str {
    let mut hash: u32 = 2166136261; // FNV-1a offset basis
    for byte in peer_id.as_bytes() {
        hash ^= *byte as u32;
        hash = hash.wrapping_mul(16777619);
    }
    COLORS[(hash as usize) % COLORS.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_peer_id_always_same_color() {
        let id = "abc-123-peer";
        assert_eq!(color_for_peer(id), color_for_peer(id));
    }

    #[test]
    fn result_is_always_one_of_the_palette_colors() {
        for id in ["a", "bb", "ccc", "some-uuid-like-thing", ""] {
            assert!(COLORS.contains(&color_for_peer(id)));
        }
    }
}
