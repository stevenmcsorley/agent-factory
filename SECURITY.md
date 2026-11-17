# Security policy

Agent Factory executes code written by AI agents in Docker sandboxes, so security reports are taken seriously.

**Report a vulnerability privately** using GitHub's "Report a vulnerability" button on the Security tab of this repository. Please do not open a public issue for security problems. Include what you did, what you expected, what happened, and your Docker/Node versions.

In scope: sandbox or egress-proxy escapes, UI/API authentication or CSRF/DNS-rebinding bypasses, credential exposure in logs or containers, protected-path bypasses, and ways for an unauthorised ticket author to queue work.

Out of scope: prompt-injection that a *permitted* ticket author deliberately performs (review every PR), and Docker/kernel vulnerabilities themselves.

This is early software; there is no formal SLA, but reports get a human reply.
