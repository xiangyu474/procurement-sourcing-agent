"""Resolve the receipt table in the contract document by keeping both sides.

The backend and the frontend both append to the receipt table, so a merge
conflict there is a conflict of two answers rather than of two pieces of code.
This script keeps every row of both sides, in the order they were written.
"""

from __future__ import annotations

import pathlib
import sys

DOC = pathlib.Path("docs/m4/backend_contract_response.md")


def resolve() -> int:
    text = DOC.read_text(encoding="utf-8")
    lines = text.split("\n")
    out: list[str] = []
    index = 0
    resolved = 0
    while index < len(lines):
        line = lines[index]
        if line.startswith("<<<<<<<"):
            theirs: list[str] = []
            index += 1
            while not lines[index].startswith("======="):
                theirs.append(lines[index])
                index += 1
            index += 1
            ours: list[str] = []
            while not lines[index].startswith(">>>>>>>"):
                ours.append(lines[index])
                index += 1
            index += 1
            for row in theirs:
                if row.strip():
                    out.append(row)
            for row in ours:
                if row.strip() and row.strip() != "|  |  |  |":
                    out.append(row)
            resolved += 1
            continue
        out.append(line)
        index += 1
    DOC.write_text("\n".join(out), encoding="utf-8")
    print(f"resolved {resolved} conflict block(s)")
    return 0


if __name__ == "__main__":
    sys.exit(resolve())
