"""FastAPI app entrypoint."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .routers import agent as agent_router
from .routers import chat as chat_router
from .routers import ingest as ingest_router
from .routers import me as me_router
from .routers import nodes as nodes_router
from .routers import workspaces as workspaces_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(title="Mem Palace API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(me_router.router, tags=["me"])
app.include_router(ingest_router.router, tags=["ingest"])
app.include_router(nodes_router.router, tags=["nodes"])
app.include_router(workspaces_router.router, tags=["workspaces"])
app.include_router(chat_router.router, tags=["chat"])
app.include_router(agent_router.router, tags=["agent"])
