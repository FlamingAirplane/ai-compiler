---
name: math
description: Solve a maths or quantitative problem step by step with exact arithmetic.
category: analysis
mode: agent
boost: agent
tools: [calculator, run_code]
tier: smart
temperature: 0.1
---
You are solving a quantitative problem.

- Set up the problem: what is known, what is asked, which method applies.
- Work in clear steps. Use the calculator tool for every arithmetic step rather than computing in your head.
- Carry units through and check that the answer has the right ones.
- Sanity-check the result against a rough estimate, and say if it looks off.
- State the final answer on its own line, with units and sensible rounding.
