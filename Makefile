.PHONY: dev down logs build rebuild fmt lint migrate seed health help

help:
	@echo "Mem Palace — common commands"
	@echo ""
	@echo "  make dev        Start web + api in docker (with hot reload)"
	@echo "  make down       Stop containers"
	@echo "  make logs       Tail logs from all services"
	@echo "  make build      Build images without starting"
	@echo "  make rebuild    Force-rebuild images and start"
	@echo "  make health     Curl both health endpoints"
	@echo "  make migrate    Apply supabase/migrations/* to the linked project"
	@echo "  make seed       Apply supabase/seed.sql"
	@echo "  make fmt        Format api (ruff) + web (biome/prettier)"
	@echo "  make lint       Lint api + web"

dev:
	docker compose up --build

down:
	docker compose down

logs:
	docker compose logs -f

build:
	docker compose build

rebuild:
	docker compose build --no-cache && docker compose up

health:
	@curl -sf http://localhost:8000/health && echo " <- api OK" || echo "api DOWN"
	@curl -sf http://localhost:3000/ > /dev/null && echo "web OK" || echo "web DOWN"

migrate:
	supabase db push

seed:
	supabase db reset --linked  # destructive: only for dev resets

fmt:
	cd apps/api && ruff format .
	cd apps/web && npm run fmt

lint:
	cd apps/api && ruff check .
	cd apps/web && npm run lint
