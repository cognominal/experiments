# jq-sh

Interactive shell that treats each input line as one of:
- A JSON file path: prints line/char counts and stores the raw file content as the previous result.
- A directory path: changes the current working directory (previous result unchanged).
- A jq script: runs `jq <script>` with the previous result as stdin and prints the output.

Prompt format: `<cwd> <command-index> >`, where `<cwd>` is absolute (or `~user` when inside that home). Command index starts at 0 and increments each line. The initial previous result is `null`.

Notes:
- Commands starting with `.` are treated as paths first; if missing, they are treated as jq scripts.
- Errors (cd failure, unreadable file, jq syntax errors) print in red.

## Run

```sh
bun install
bun run start
```
