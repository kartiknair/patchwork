/// Current wall-clock time in integer milliseconds, used to seed RoomState's
/// hybrid logical clock. Split out so state.rs (and its tests) stay free of
/// wasm-only dependencies.
pub fn wall_clock_ms() -> u64 {
    js_sys::Date::now() as u64
}
