#!/bin/sh
# Run after creating an empty GitHub repository. No tokens are stored here.
set -eu
if [ "$#" -ne 1 ]; then
  printf '%s\n' 'Usage: ./publish.sh https://github.com/OWNER/REPOSITORY.git' >&2
  exit 2
fi
case "$1" in
  https://github.com/*/*.git|git@github.com:*/*.git) ;;
  *) printf '%s\n' 'Use the clone URL of your empty GitHub repository.' >&2; exit 2 ;;
esac
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
test -s dist/index.html
test -s dist/config.json
test -s .github/workflows/pages.yml
if [ ! -d .git ]; then
  git init -b main .
fi
if [ "$(git branch --show-current)" != main ]; then
  printf '%s\n' 'This prepared repository must be on main before publishing.' >&2
  exit 2
fi
if git remote get-url origin >/dev/null 2>&1; then
  if [ "$(git remote get-url origin)" != "$1" ]; then
    printf '%s\n' 'Existing origin differs; inspect it before changing the destination.' >&2
    exit 2
  fi
else
  git remote add origin "$1"
fi
git add -- .gitignore README.md publish.sh .github/workflows/pages.yml dist
if [ -d model-files ]; then
  git add -- model-files
fi
if ! git diff --cached --quiet; then
  git -c user.name='Great Kingdom deployment' -c user.email='deployment@users.noreply.github.com' commit -m 'Prepare browser-only Great Kingdom practice'
fi
git push -u origin main
printf '%s\n' 'Next: GitHub repository Settings > Pages > Source: GitHub Actions.'
