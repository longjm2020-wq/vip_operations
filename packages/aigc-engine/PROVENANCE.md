# AIGC creation engine

Ported from the user-specified repository https://github.com/longjm2020-wq/zhiying-replica-studio at commit `1cfe787f57728b6f4a51c59caa8b1db1059c49d9` (0.3.92), 2026-10-26.

Selected cloud short-video, ecommerce image, digital-human, work-library and featured-template workflows. Desktop automation, browser sessions, standalone registration/login, wallets, recharge, memberships, sales pricing and payment administration are not integrated. No upstream deployment data or credentials are copied.

Local adaptations: shared website authentication/permissions, PostgreSQL state with an exclusive scheduler lease, durable media storage, encrypted provider configuration, same-origin authenticated downloads, and nonfinancial submission receipts that preserve upstream duplicate-request prevention. The UI is implemented natively with this website's React/Ant Design theme.
