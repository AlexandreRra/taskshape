# Contributing

- Python 3.12, standard library only in `taskshape.*` except behind the `laya` extra (`lab.py` and
  `router.LayaBackend` import torch and laya lazily).
- Every behaviour change ships with a test in `tests/` that fails without it. Run
  `python3 -m unittest discover -s tests` (no ML dependencies needed).
- Catalog edits (`catalog/models.json`) must carry a source URL and the `as_of` date; numbers are
  directional, not acceptance criteria.
- A checkpoint is adopted only through `taskshape lab adopt` with both evaluation reports attached;
  never commit weights.
- No provider calls anywhere in this repository. Routing and training run offline.
