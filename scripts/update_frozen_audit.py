"""Update the frozen regression fixture with the audited ground truth.

The four models are the ones whose verdict moved between two runs of the same
code. Their inputs stay frozen. The expected verdicts are the ones that were
read off the raw evidence by hand, with the reasoning written down so that a
later reader can check the reading.
"""

from __future__ import annotations

import json
from pathlib import Path

FIXTURE = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "m3_semantic_regression.json"

AUDIT = {
    "IPS05-R10-OIA4": {
        "verdict": "FAIL",
        "reason": (
            "The only quotation that names the resolution is 'Support multiple streams, up to "
            "2560 x 1920 resolution'. That is the highest output the source states, and "
            "2560 x 1920 is 4.92 MP, below the required 5 MP. The '5MP' of this model appears "
            "only inside product titles ('Camera IPS05-R10-OIA4 ILL Pro4 5MP Corner'), which name "
            "a product and do not state a measurement."
        ),
        "typed_claim_id": "clm_2baeb07504f65dda4be261e5",
        "typed_value": "2560 x 1920",
        "typed_unit": "pixels",
    },
    "NBN-80052-BA": {
        "verdict": "PASS",
        "reason": (
            "The source states the resolution in words: 'Capturing 16:9 images at 5 megapixel "
            "resolution (3K)'. That is 5 MP against the required 5 MP. The other quotations name "
            "the effective camera resolution or the frame rate at that resolution, which state "
            "the same quantity."
        ),
        "typed_claim_id": "clm_65aab6fddd53192b53aa25df",
        "typed_value": "5",
        "typed_unit": "MP",
    },
    "TRI050S-MC": {
        "verdict": "PASS",
        "reason": (
            "The source states the resolution as a pixel size, '5.0 MP, 2448 x 2048 px'. "
            "2448 x 2048 is 5.01 MP, which meets the required 5 MP."
        ),
        "typed_claim_id": "clm_3bf4cc30b70ccdc4374d67e5",
        "typed_value": "2448 x 2048",
        "typed_unit": "pixels",
    },
    "TRI055N": {
        "verdict": "PASS",
        "reason": (
            "The source states the resolution and the frame rate together: 'delivering 2,592 x "
            "1,944 resolution at up to 22.1 frames per second'. 2592 x 1944 is 5.04 MP, which "
            "meets the required 5 MP."
        ),
        "typed_claim_id": "clm_453a5ba6bd8a4c10d447c4f8",
        "typed_value": "2592 x 1944",
        "typed_unit": "pixels",
    },
}


def main() -> int:
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    data["note"] = (
        "Frozen inputs of the four models whose verdict moved between two runs of the same "
        "code. The expected verdicts were read off the raw evidence by hand. A quotation that "
        "names a product rather than a measurement cannot carry a verdict: the '5MP' of a "
        "product title is part of the name."
    )
    for model, entry in AUDIT.items():
        data["models"].setdefault(model, {})["audit"] = {
            "verdict": entry["verdict"],
            "reason": entry["reason"],
        }
    FIXTURE.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("fixture updated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
