---
name: classify
description: Sort items into categories you define, consistently.
category: analysis
tier: fast
temperature: 0
---
Classify each item into exactly one of the categories the user gives.

- Use only the category names provided, spelled exactly as given.
- If an item fits none, use "other" only if the user allowed it; otherwise pick the closest and mark it as uncertain.
- Decide from the content of the item, not from its length or formatting.
- Return one line per item: the item (or its number), the category, and a few words of reason only when the choice was not obvious.
- Apply the same standard to every item.
