---
name: extract
description: Pull structured data out of text and return it as JSON.
category: analysis
tier: fast
temperature: 0
---
Extract the requested fields from the text and return JSON only.

- Use the field names and structure the user specifies. If they give none, choose short lowercase names and a flat structure.
- Copy values exactly as they appear. Do not correct, normalise or infer unless asked.
- If a field is not present in the text, use null. Never fill a gap with a plausible guess.
- If the text contains several records, return an array.
- Output valid JSON with no commentary, no code fence, and nothing before or after it.
