import os
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from azure.communication.identity import CommunicationIdentityClient
from azure.communication.networktraversal import CommunicationRelayClient

from .languages import LANGUAGE_MAP


BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

SPEECH_REGION = os.getenv("SPEECH_REGION", "southeastasia")
SPEECH_KEY = os.getenv("SPEECH_KEY")
ACS_CONNECTION_STRING = os.getenv("ACS_CONNECTION_STRING")

if not SPEECH_KEY:
    raise RuntimeError("Missing SPEECH_KEY environment variable")
if not ACS_CONNECTION_STRING:
    raise RuntimeError("Missing ACS_CONNECTION_STRING environment variable")

AVATAR_CHARACTER = "Meg"
AVATAR_STYLE = "business"

SPEECH_TOKEN_REFRESH_SEC = 8 * 60
ICE_REFRESH_SEC = 20 * 60

_speech_token_cache: Dict[str, Any] = {"token": None, "ts": 0.0}
_ice_cache: Dict[str, Any] = {"ice": None, "ts": 0.0}

app = FastAPI(title="Kiosk Real-time Avatar (ACS + Speech)")


class SessionRequest(BaseModel):
    language: str = "en-SG"
    avatarCharacter: Optional[str] = AVATAR_CHARACTER
    avatarStyle: Optional[str] = AVATAR_STYLE


class CacheControlStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):  # type: ignore[override]
        response = await super().get_response(path, scope)
        if response.status_code == 200 and path.endswith(
            (".js", ".css", ".png", ".jpg", ".jpeg", ".svg", ".ico", ".woff", ".woff2")
        ):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


if STATIC_DIR.exists():
    app.mount("/static", CacheControlStaticFiles(directory=str(STATIC_DIR)), name="static")


@app.middleware("http")
async def add_no_store_for_html(request: Request, call_next):
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.endswith(".html"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/")
def home():
    index = STATIC_DIR / "index.html"
    if not index.exists():
        raise HTTPException(status_code=500, detail="Missing static/index.html")
    return FileResponse(index)


@app.get("/api/health")
def health():
    return JSONResponse({"ok": True, "time": int(time.time())})


@app.get("/api/languages")
def list_languages():
    return {
        "languages": [
            {"code": code, "label": meta["label"], "voice": meta["voice"]}
            for code, meta in LANGUAGE_MAP.items()
        ]
    }


async def get_speech_token() -> str:
    now = time.time()
    if _speech_token_cache["token"] and (now - _speech_token_cache["ts"] < SPEECH_TOKEN_REFRESH_SEC):
        return _speech_token_cache["token"]

    token_url = f"https://{SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken"
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.post(token_url, headers={"Ocp-Apim-Subscription-Key": SPEECH_KEY})

    if response.status_code != 200:
        raise HTTPException(status_code=500, detail=f"Failed to get Speech token: {response.text}")

    token = response.text
    _speech_token_cache["token"] = token
    _speech_token_cache["ts"] = now
    return token


def _fetch_ice_servers_sync() -> List[Dict[str, Any]]:
    identity_client = CommunicationIdentityClient.from_connection_string(ACS_CONNECTION_STRING)
    relay_client = CommunicationRelayClient.from_connection_string(ACS_CONNECTION_STRING)

    user = identity_client.create_user()
    config = relay_client.get_relay_configuration(user=user)

    ice_servers: List[Dict[str, Any]] = []
    for server in config.ice_servers:
        ice_servers.append({"urls": server.urls, "username": server.username, "credential": server.credential})
    return ice_servers


async def get_ice_servers() -> List[Dict[str, Any]]:
    now = time.time()
    if _ice_cache["ice"] and (now - _ice_cache["ts"] < ICE_REFRESH_SEC):
        return _ice_cache["ice"]

    ice = await run_in_threadpool(_fetch_ice_servers_sync)
    _ice_cache["ice"] = ice
    _ice_cache["ts"] = now
    return ice


@app.post("/api/session")
async def create_session(req: SessionRequest):
    try:
        if req.language not in LANGUAGE_MAP:
            raise HTTPException(status_code=400, detail="Unsupported language")

        speech_token = await get_speech_token()
        ice_servers = await get_ice_servers()
        voice = LANGUAGE_MAP[req.language]["voice"]

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error creating session: {str(e)}")


    return {
        "sessionId": str(uuid.uuid4()),
        "speechToken": speech_token,
        "speechRegion": SPEECH_REGION,
        "iceServers": ice_servers,
        "language": req.language,
        "voice": voice,
        "avatarCharacter": req.avatarCharacter or AVATAR_CHARACTER,
        "avatarStyle": req.avatarStyle or AVATAR_STYLE,
    }
