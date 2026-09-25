# Audio loads and saved mix identity

Core may announce one load twice: a canonical playback event plus a legacy song
event. Its persisted settings key can also change from a provisional local key
to a format-specific key once metadata arrives. Neither transition identifies
different audio.

`LoadIdentity` merges the two loading aliases, remembers retired sessions, and
keeps real restarts and song changes distinct. Canonical events without filenames
wait for the matching filename rather than preloading the previous song. Preload
results are generation checked, including after leaving the player.

The audio signature covers the filename, stems, and pristine full-mix URL, not
the persisted settings key. A settings update changes gains on the existing
graph. Both decoded and streaming paths use the same preference lookup, with
the canonical key taking precedence and legacy filename settings as fallback.
Current-load manual changes follow the final key; temporary claims remain active
and defer preference reconciliation until their release.

Tests exercise real lifecycle handlers with both alias orders, key promotion,
ready-only entry, duplicate ready events, source changes, stale sessions and
restarts; preference tests cover canonical/legacy precedence, manual edits and
claims. Actual cold-renderer and delayed-worklet acceptance remains necessary
in addition to unit tests.
