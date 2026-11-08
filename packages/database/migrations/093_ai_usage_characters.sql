-- Keep provider-reported character usage separate from tokens, credits and money.
ALTER TABLE public.ai_model_usage
  ADD COLUMN input_characters NUMERIC CHECK (input_characters >= 0);
