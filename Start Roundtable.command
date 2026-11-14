#!/bin/zsh
# Finder starts with a limited PATH; include standard macOS Node locations.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd -- "${0:A:h}" || exit 1

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  print "Roundtable needs Node.js 22.12 or newer. Install it from https://nodejs.org, then open this launcher again."
  read -r "?Press Return to close. "
  exit 1
fi

if [[ ! -d node_modules ]]; then
  print "Installing Roundtable for the first time (internet required)…"
  npm ci || { read -r "?Installation failed. Press Return to close. "; exit 1; }
fi

print "Starting your table. Keep this window open while you play."
npm start -- --open
exit_code=$?
if [[ $exit_code -ne 0 ]]; then
  read -r "?Roundtable stopped. Read the message above, then press Return to close. "
fi
exit $exit_code
