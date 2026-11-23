-- Match the raised knowledgeContentLimit in packages/contracts/src/assistant-knowledge.ts; existing revisions stay valid.
ALTER TABLE public.assistant_knowledge_revisions
  DROP CONSTRAINT IF EXISTS assistant_knowledge_revisions_content_check;
ALTER TABLE public.assistant_knowledge_revisions
  ADD CONSTRAINT assistant_knowledge_revisions_content_check
  CHECK (length(content) BETWEEN 1 AND 1000000);
