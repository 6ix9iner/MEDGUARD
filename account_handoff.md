# Account Handoff: Autonomous Clinical Workflow Agent Project

Date: 2026-05-19

## Current Conversation

The user said they will soon switch to another account and asked Codex to:

- Read `confirmed ai project.txt`.
- Store the conversation/context in a Markdown file.

This file is the handoff note for the next account/session.

## Workspace

Current workspace:

```text
C:\Users\david\autonomous cwadir
```

Important file read:

```text
confirmed ai project.txt
```

## Project Identity

Project title:

```text
Autonomous Clinical Workflow Agent for Drug Interaction Review
```

Institution:

```text
Lagos State University, Ojo, Lagos
Department of Computer Science, Faculty of Computing
```

Student:

```text
Adeniyi Oluwasemilore Ademola
Matric No: 220591030
```

Supervisor:

```text
Dr. Raji Lawal
```

Document type:

```text
Final Year Project Proposal
```

Document date:

```text
February 2026
```

## Project Summary

The project proposes a prototype autonomous AI-based clinical workflow agent for drug-drug interaction review. The goal is to improve medication safety by producing more contextual, explainable, and clinically relevant drug interaction alerts.

The proposal argues that traditional Clinical Decision Support Systems often generate too many low-value alerts, causing alert fatigue. Clinicians may override most alerts because many are irrelevant, poorly contextualized, or disconnected from real workflow conditions. The project positions an autonomous workflow agent as a decision-support tool that augments clinicians rather than replacing them.

The system concept combines:

- Rule-based drug interaction checking.
- Retrieval-Augmented Generation, or RAG, to ground outputs in external/verifiable knowledge.
- LLM-based reasoning for context-aware interpretation.
- Agent-based workflow orchestration for multi-step clinical review.
- Explainable alert generation to support clinician trust.

## Core Problem

Existing drug interaction review systems are described as:

- Overly static and rule-based.
- Poor at incorporating patient-specific context.
- Prone to producing excessive irrelevant alerts.
- A contributor to alert fatigue and high override rates.
- Insufficiently validated for real-world clinical use.
- Often weak on explainability, privacy, bias, and governance.

The document repeatedly frames alert fatigue as the central practical problem. It cites high alert override rates and low alert appropriateness as evidence that current CDSS alerts are not sufficiently useful in clinical workflows.

## Aim

The stated aim is to conceptualize, develop, and evaluate an autonomous AI agent using LLM reasoning to analyze patient profiles and deliver accurate, contextual, explainable drug interaction alerts that reduce alert fatigue.

## Objectives

The proposal lists these objectives:

1. Examine existing Clinical Decision Support Systems and limitations in drug interaction alerting.
2. Analyze the causes and implications of alert fatigue in clinical workflows.
3. Design a system architecture for an autonomous clinical workflow agent.
4. Implement a drug interaction review mechanism using structured rules and retrieval-based knowledge augmentation.
5. Develop a user interface that integrates into clinical workflows.
6. Evaluate the system's ability to reduce irrelevant alerts and improve interaction relevance.

## Research Questions

The proposal asks:

1. What are the key limitations of existing CDSS in managing drug interaction alerts?
2. How can an autonomous agent improve contextual relevance and workflow integration in drug interaction review?
3. In what ways can retrieval-based knowledge augmentation enhance the reliability of interaction alerts?
4. How does autonomous workflow integration impact alert fatigue and clinician usability?

## Scope

The scope is a prototype autonomous clinical workflow agent for drug-drug interaction review.

Included:

- Prescribed medications.
- Predefined drug database and knowledge sources.
- Decision support for clinicians.
- Controlled test scenarios.

Excluded:

- Live hospital deployment.
- Replacement of clinical judgment.
- Drug-food interactions.
- Drug-disease interactions.
- Full regulatory compliance implementation.

## Limitations

The proposal notes:

- Evaluation will use controlled test scenarios rather than live clinical data.
- Accuracy depends on the quality and completeness of the drug interaction knowledge base.
- Ethical and privacy issues are addressed conceptually, not through full regulatory compliance.
- LLM hallucination remains a major risk.
- LLM knowledge can become outdated.
- Clinical reasoning may exceed what an AI system can reliably infer.

## Literature Review Themes

The document organizes the literature review around four main themes:

1. Evolution of CDSS and alert fatigue.
2. LLMs in healthcare and their limitations.
3. RAG and knowledge augmentation for clinical decision support.
4. Autonomous agents in clinical workflows.

Key takeaways:

- Traditional CDSS can reduce medication errors but often creates excessive alerts.
- Alert fatigue is a major usability and safety issue.
- LLMs offer reasoning and summarization benefits, but hallucination, bias, outdated knowledge, and opacity are serious risks.
- RAG helps by grounding LLM outputs in retrievable knowledge, but clinical validation is still limited.
- Autonomous agents can coordinate multi-step tasks, but most healthcare-agent studies remain simulated or retrospective.
- The literature gap is the lack of prospective real-world validation and operational ethical governance.

## Likely Implementation Direction

A reasonable prototype based on the proposal would include:

- A clinician-facing web interface.
- Patient profile input: age, sex, diagnoses/comorbidities, renal/hepatic status, labs, medications, doses.
- Drug interaction checker using a structured local knowledge base.
- Retrieval layer for supporting evidence and citations.
- Agent workflow that:
  1. Parses patient and medication data.
  2. Checks known drug-drug interactions.
  3. Retrieves supporting knowledge.
  4. Applies patient-specific risk modifiers.
  5. Ranks severity and relevance.
  6. Produces explainable alerts.
  7. Allows clinician review/override.
- Evaluation using controlled clinical scenarios, comparing irrelevant alert rate, clinically relevant alert detection, and usability.

## Important Design Principle

The system should be framed as clinical decision support, not autonomous diagnosis or treatment. It should clearly communicate that final decisions remain with licensed clinicians.

## Next Account Should Know

The user may ask for help turning this proposal into a working project. The best next steps are likely:

- Clean and structure the proposal text.
- Extract functional requirements.
- Design the system architecture.
- Choose a prototype stack.
- Build the drug interaction review prototype.
- Create test scenarios and evaluation metrics.
- Prepare chapters 3-5 or implementation documentation.

The source text contains many invisible/odd Unicode characters, likely from copy/paste or formatting. If editing or converting it, normalize the text before using it in code, citations, or final submission.

