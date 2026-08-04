#!/usr/bin/env bash
# Regenerate ALL diagrams from source and sync the copies the SageMaker notebook uses.
#
# Why this exists: the notebook renders its images from its own directory
# (cdk/notebook/*.png) because that whole folder is uploaded to S3 by the CDK
# BucketDeployment. Those files are copies of docs/diagrams/*, so they can drift
# from the source and show stale architecture (this has happened twice).
# ALWAYS run this after editing any diagram source, then redeploy the notebook stack.
#
# Requires: graphviz (dot). rsvg-convert only if regenerating PNGs from SVG sources.
set -euo pipefail
cd "$(dirname "$0")"                     # docs/diagrams
ROOT=$(cd ../.. && pwd)
NB="$ROOT/cdk/notebook"
# Find REAL graphviz dot (a mise/python shim named "dot" can shadow it on PATH).
DOT=""
for c in /opt/homebrew/bin/dot /usr/local/bin/dot /usr/bin/dot "$(command -v dot 2>/dev/null || true)"; do
  if [ -n "$c" ] && [ -x "$c" ] && "$c" -V 2>&1 | grep -qi graphviz; then DOT="$c"; break; fi
done
if [ -z "$DOT" ]; then echo "ERROR: graphviz 'dot' not found (brew install graphviz)"; exit 1; fi
echo "using dot: $DOT"

echo "── Graphviz sources → svg + png ──"
for d in architecture fault-scenario; do
  [ -f "$d.dot" ] || continue
  "$DOT" -Tsvg "$d.dot" -o "$d.svg"
  "$DOT" -Tpng -Gdpi=140 "$d.dot" -o "$d.png"
  echo "   $d.svg + $d.png"
done

echo "── AWS Guidance diagram (pptx + svg + png) ──"
if command -v node >/dev/null; then
  node generate-guidance-pptx.cjs 5g-rcf-architecture-guidance.pptx >/dev/null
  node generate-guidance-svg.cjs  5g-rcf-architecture-guidance.svg  >/dev/null
  if command -v rsvg-convert >/dev/null; then
    rsvg-convert -w 2560 5g-rcf-architecture-guidance.svg -o 5g-rcf-architecture-guidance.png
  fi
  echo "   5g-rcf-architecture-guidance.{pptx,svg,png}"
fi

echo "── sync the notebook's image copies (cdk/notebook/) ──"
for f in architecture.png fault-scenario.png rcf-dataflow.png; do
  if [ -f "$f" ]; then
    cp "$f" "$NB/$f" && echo "   synced $f"
  elif [ -f "${f%.png}.svg" ] && command -v rsvg-convert >/dev/null; then
    rsvg-convert -w 1800 "${f%.png}.svg" -o "$NB/$f" && echo "   rendered ${f%.png}.svg → $NB/$f"
  else
    echo "   ! skipped $f (no source found)"
  fi
done

echo
echo "Done. Next: regenerate the notebook and redeploy so the new images reach S3:"
echo "  python3 cdk/notebook/generate_notebook.py cdk/notebook/rcf-anomaly-detection-demo.ipynb"
echo "  cd cdk && npx cdk deploy Open5gsNotebookStack   # then Stop/Start the notebook instance"
