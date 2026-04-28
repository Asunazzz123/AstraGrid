.PHONY: build dev gateway agent

build:
	npm run build

dev:
	bash start.sh

gateway:
	npx tsx packages/gateway/src/index.ts

agent:
	AGENT_CONFIG=$$(cat agent-config.json) npx tsx packages/agent/src/index.ts
