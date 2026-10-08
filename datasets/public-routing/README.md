# public-routing dataset

This directory contains agent-authored synthetic task briefs for exercising taskshape routing labels.
The rows are not real user data, copied project records or externally validated human labels.

## Files

- `train.jsonl`: 160 labelled briefs.
- `heldout.jsonl`: 56 labelled briefs with task families/templates distinct from the training split.

## Schema

Each JSONL row has:

- `id`: stable row id.
- `language`: `en` or `pt-BR`.
- `source`: always `synthetic-curated`.
- `phase`: `work` or `review`.
- `shape`: one of the shapes from `src/taskshape/shapes.py` allowed for the phase.
- `template`: synthetic family id used to keep train and heldout families distinct.
- `task`: the task brief text.

## Label Scope

Work-phase rows cover `lookup`, `routine`, `demanding`, `visual`, `coupled` and `architecture`.
Review-phase rows cover `review` and `architecture`.

The labels are intended to match the current taskshape shape criteria. They can be used to evaluate a
specialized classifier against the heldout split, but they are not production proof of routing quality.

## Current public evaluation

These numbers describe this small synthetic held-out fixture only. They are not production-quality claims.

| Classifier | Heldout correct | Accuracy | English | Portuguese | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| Heuristic rubric | 29/56 | 51.79% | 18/28 | 11/28 | Dependency-free rule baseline. |
| Pinned public multilingual Laya base | 24/56 | 42.86% | 11/28 | 13/28 | Default plugin checkpoint with taskshape definitions supplied in the question. |
| Four-epoch public candidate | 24/56 | 42.86% | 11/28 | 13/28 | Rejected by the adoption gate because it did not improve accuracy. |

`evaluation.json` and `comparison.md` contain the public evaluation metadata and prediction ids. They do not include the task text from the held-out rows. Reproduce the Laya run with `scripts/train-public.py` after installing the optional ML dependencies and preparing the local base checkpoint.
