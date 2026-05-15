from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All env-driven config in one place.

    Required env vars come from .env (see .env.example at repo root).
    Missing any of them = crash at import time, which is the right failure mode.
    """

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    # Supabase
    supabase_url: str
    supabase_anon_key: str
    supabase_service_role_key: str
    supabase_jwt_secret: str

    # OpenAI
    openai_api_key: str
    openai_embedding_model: str = "text-embedding-3-small"
    openai_chat_model: str = "gpt-4o-mini"

    # App
    api_cors_origins: str = "http://localhost:3000"

    # Retrieval — flip to false to disable LLM query rewriting on multi-turn /chat.
    # When true and the request carries history, one extra LLM call rewrites
    # the user's question into a standalone search query before embedding.
    query_rewrite_enabled: bool = True

    # Retrieval — LLM-as-judge reranker on top-N candidates → top-K. Adds one
    # cheap LLM call (gpt-4o-mini, JSON mode, ~80 tokens out) per chat turn,
    # but auto-skips when the top candidate clearly dominates (sim gap > 0.10).
    rerank_enabled: bool = True

    # Agent reflection — after /agent produces a final answer, an LLM judge
    # scores it 1-5 on grounding + completeness. If score < REFLECTION_RETRY_BELOW
    # and we haven't already retried, the agent gets ONE more attempt with
    # the judge's issues fed back as context. Cap at 1 retry. Adds 1-2 LLM
    # calls per agent turn worst-case (judge + maybe a second agent run).
    reflection_enabled: bool = True
    # Score strictly below this triggers a retry. 4 = "needs improvement"
    # threshold on a 1-5 rubric (5 perfect, 4 good enough, 3 mediocre).
    reflection_retry_below: int = 4

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.api_cors_origins.split(",") if o.strip()]


settings = Settings()  # type: ignore[call-arg]
