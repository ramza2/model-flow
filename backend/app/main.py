from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import router
from app.core.config import settings

app = FastAPI(title=settings.app_name, version="0.1.0")

origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins or ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    return JSONResponse(
        status_code=500,
        content={
            "detail": "Something went wrong while processing your request.",
            "hint": str(exc),
        },
    )


app.include_router(router, prefix="/api")


@app.get("/")
def root():
    return {"name": settings.app_name, "docs": "/docs"}
