#!/bin/sh
# Publish the site: typecheck, test, build, and force-push dist/ to the
# gh-pages branch, which GitHub Pages serves at
# https://yig.github.io/ScaffoldSketchWeb/. Run from a clean checkout of main.
set -e
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain)" ]; then
  echo "Commit or stash your changes first (the site records the commit it was built from)." >&2
  exit 1
fi
npm run typecheck
npm test
npx vite build
touch dist/.nojekyll
commit=$(git rev-parse --short HEAD)
remote=$(git remote get-url origin)
tmp=$(mktemp -d)
cp -R dist/. "$tmp"
cd "$tmp"
git init -q -b gh-pages
git add -A
git commit -q -m "Site built from $commit"
git push -q -f "$remote" gh-pages
cd - > /dev/null
/bin/rm -rf "$tmp"
echo "Pushed gh-pages (built from $commit). GitHub Pages updates in a minute or so."
