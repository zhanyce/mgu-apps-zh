# Third-party code

| Path | What | Licence |
|---|---|---|
| `kit/` | the app kit of [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) (see `kit/VENDORED.md`) | MIT, `kit/LICENSE` |
| `kit/runtime/fonts/*.json`, `kit/localization/fonts/es/*.json` | glyph atlases baked from the Ubuntu font | Ubuntu Font Licence 1.0 |
| `kit/runtime/fonts/gear_barlow.json` | Barlow SemiBold digits | SIL OFL 1.1, `kit/runtime/fonts/OFL-Barlow.txt` |
| `apps/rubenrios_gearhud/cluster_render_client.js` | the Node client of [cluster-render](https://github.com/robertnisipeanu/idrive-apps/tree/main/native/cluster-render), © Robert Nisipeanu | MPL-2.0 (its header) |

No BMW code: the Store builds the app on the head unit with the oap-sdk it takes from a stock BMW app on the car.
The rest (`apps/rubenrios_gearhud/` except the client above, `tools/`) is MIT, `LICENSE`.
