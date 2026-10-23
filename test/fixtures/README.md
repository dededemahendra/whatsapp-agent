# fake-wacli

`fake-wacli.mjs` stands in for the real `wacli` binary in tests. Point the
runner at it with `bin: FAKE_WACLI`. It never talks to WhatsApp.

Behaviour is controlled by environment variables:

| Variable | Effect |
| --- | --- |
| `FAKE_WACLI_FIXTURES` | Directory of response files. Default: `responses/` next to the script. |
| `FAKE_WACLI_LOG` | Append one JSON line per invocation: `{argv, key, env}`, where `env` holds the `WACLI_READONLY`, `WACLI_MEDIA_ROOTS` and `NO_COLOR` values the fake saw. |
| `FAKE_WACLI_FAIL` | `"<key>\|<exit code>\|<message>"`. When the command key matches (or key is `*`), print wacli's JSON error envelope to stderr and exit with the code. |
| `FAKE_WACLI_SLEEP_MS` | Sleep before answering (timeout tests). |
| `FAKE_WACLI_BIG` | `1` prints 20 MiB of `x` to stdout (output cap tests). |
| `FAKE_WACLI_VERSION` | Text printed by `version`. Default `0.22.0`. A version below 0.22.0 also makes any call carrying `--read-only` or `--account` exit 1 with `Error: unknown flag: <flag>` and a usage text on stderr, like an old wacli. |
| `FAKE_WACLI_EMPTY` | Comma-separated keys that answer an empty result the way wacli encodes it: `{"success":true,"data":null}`, or for the message pages and `messages context` the fixture's own wrapper with `"messages": null`. |
| `FAKE_WACLI_STORE_DIR` | Replaces `__STORE_DIR__` in fixtures (doctor). |
| `FAKE_WACLI_WARN` | `repeated` writes `warning: repeated send within 5 seconds` to stderr alongside a successful response. |
| `FAKE_WACLI_SYNC` | Script for `sync`: segments per attempt separated by `\|`, steps by `;`. Steps: an event name (emitted as NDJSON on stderr), `sleep:<ms>`, `exit:<code>`, `crash`, `text` (a non-JSON stderr line), `ignore-term` (stop handling SIGTERM, so only SIGKILL ends the process), `error:<message>` (an `error` event carrying the message, the shape wacli uses under `--events`). |
| `FAKE_WACLI_SYNC_COUNTER` | File holding the attempt number, so each `sync` spawn gets the next segment. |

The fixtures were derived from the wacli source and documentation. They were not
captured from a live run, so the manual acceptance run and the read-only smoke
test (`pnpm test:smoke`) are what verify them against a real wacli.

The command key is the subcommand path with global flags removed, for
example `chats list`, `messages search`, `send text`, `groups participants list`.
The response file is the key with spaces replaced by `_` plus `.json`.

`media download` writes a 1x1 PNG to `--output` (a file path, or a directory
in which case `<id>.png`) and substitutes `__OUTPUT__` and `__BYTES__`.
