#!/bin/dash
# agentbox PreToolUse hook prefilter, installed as ~/.local/share/agentbox/hook.
#
# Runs before every Bash call, so it must be cheap: dash and builtins only
# (about 1 ms). It passes the event to `agentbox github hook` only when the raw
# JSON could contain a git network command or a gh call. That test is a
# superset of classify() in src/lib/resolve.ts: false positives just cost one
# full run, false negatives must not happen.

input=
while IFS= read -r line || [ -n "$line" ]; do
  input="$input$line"
done

case $input in
  # gh followed by whitespace (raw, or JSON-escaped)
  *gh[[:space:]]* | *'gh\t'* | *'gh\n'* | *'gh\r'*) ;;
  *git*)
    case $input in
      *push* | *pull* | *fetch* | *clone* | *ls-remote* | *submodule*) ;;
      *) exit 0 ;;
    esac
    ;;
  *) exit 0 ;;
esac

# Start the binary from / rather than the agent-writable repo; the event
# carries the real working directory.
dir=${0%/*}
cd / || exit 0
printf '%s' "$input" | "$dir/agentbox" github hook
exit 0
