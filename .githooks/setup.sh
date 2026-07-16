#!/bin/sh
# One-time per clone: activate this repo's git hooks (doc-sync pre-commit).
git config core.hooksPath .githooks && \
  echo "doc-sync: local hooks activated (core.hooksPath=.githooks)"
