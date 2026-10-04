# telly synthetic family health agent

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

This agent is a demo care assistant from telly, an MHacks 2026 project. It answers questions about one synthetic demo family. All records are synthetic and were made for the demo. The agent does not give medical advice.

## What you can ask

- "Any alerts for my family?"
- "What is the latest heart rate?"
- "How is the sleep?"
- "Show recent oxygen readings"
- "Latest health readings"

The agent also knows resting heart rate, heart rate variability (HRV), and respiratory rate (breathing).

## How it works

- The agent uses the Agent Chat Protocol v0.3.0.
- One chat text maps to one tool: `alerts` or `health_samples`. A reply shows a maximum of 5 records.
- Replies show only records that are marked synthetic. The agent withholds all other records.
- A sender without a grant for the demo family gets a refusal.
- For other text, the agent replies with a short help message.

## Limits

- Synthetic demo data only. The data is not about a real person.
- The agent does not make a diagnosis.
- Do not use this agent in an emergency. Call your local emergency number.
