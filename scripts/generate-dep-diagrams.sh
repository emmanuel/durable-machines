#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$ROOT/.dependency-cruiser.mjs"

for pkg_dir in "$ROOT"/packages/*/; do
  pkg=$(basename "$pkg_dir")
  readme="$pkg_dir/README.md"
  src_dir="$pkg_dir/src"

  [[ -d "$src_dir" ]] || continue
  [[ -f "$readme" ]] || continue

  diagram_file=$(mktemp)
  depcruise "$src_dir" --config "$CONFIG" --output-type mermaid > "$diagram_file"

  if grep -q '## Dependencies' "$readme"; then
    # Replace content between ```mermaid and the next ``` inside the Dependencies section
    awk -v dfile="$diagram_file" '
      /^```mermaid$/ && dep_section {
        replacing = 1
        print
        while ((getline line < dfile) > 0) print line
        next
      }
      /^```$/ && replacing { replacing = 0; print; next }
      replacing { next }
      /^## Dependencies/ { dep_section = 1 }
      /^## / && !/^## Dependencies/ { dep_section = 0 }
      { print }
    ' "$readme" > "$readme.tmp" && mv "$readme.tmp" "$readme"
  else
    {
      printf '\n## Dependencies\n\n```mermaid\n'
      cat "$diagram_file"
      printf '```\n'
    } >> "$readme"
  fi

  rm -f "$diagram_file"
  echo "Updated $pkg/README.md"
done
