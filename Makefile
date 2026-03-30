DXKIT_ROOT := ../dxkit
SRC := src
DIST := dist
VERSION_FILE := BUILD_VERSION

DATE := $(shell date +%Y%m%d)
ITER := $(shell cat $(VERSION_FILE))
DIST_NAME := dnzn.dev-$(DATE).$(ITER)

# Routes for history-mode stubs (keep in sync with dapp manifests)
ROUTES := about projects support tools/cic tools/tpl

.PHONY: vendor serve build watch setup dist dist-history-stubs clean bump-version lint lint-fix lint-format test test-watch commit

vendor:
	@if [ ! -f $(DXKIT_ROOT)/dist/index.global.js ]; then \
		echo "Building DxKit..."; \
		$(MAKE) -C $(DXKIT_ROOT) setup build; \
	fi
	@echo "Vendoring IIFE + .d.ts files..."
	@mkdir -p $(SRC)/vendor/dxkit/theme $(SRC)/vendor/dxkit/settings
	@cp $(DXKIT_ROOT)/dist/index.global.js $(SRC)/vendor/dxkit/
	@cp $(DXKIT_ROOT)/dist/index.d.ts $(SRC)/vendor/dxkit/
	@cp $(DXKIT_ROOT)/plugins/theme/dist/index.global.js $(SRC)/vendor/dxkit/theme/
	@cp $(DXKIT_ROOT)/plugins/theme/dist/index.d.ts $(SRC)/vendor/dxkit/theme/
	@cp $(DXKIT_ROOT)/plugins/settings/dist/index.global.js $(SRC)/vendor/dxkit/settings/
	@cp $(DXKIT_ROOT)/plugins/settings/dist/index.d.ts $(SRC)/vendor/dxkit/settings/
	@echo "Vendored to $(SRC)/vendor/dxkit/"

setup:
	@npm install
	@echo "Dependencies installed"

build:
	@npx tsup
	@echo "TypeScript compiled"

watch:
	@npx tsup --watch

serve: build
	@echo "Serving $(SRC)/ on http://localhost:3000 (no live reload)"
	@npx serve $(SRC)/ --no-request-logging

bump-version:
	@echo $$(( $(ITER) + 1 )) > $(VERSION_FILE)
	@echo "Bumped BUILD_VERSION to $$(cat $(VERSION_FILE))"

dist: build bump-version
	@mkdir -p $(DIST)/$(DIST_NAME)
	@cp -a $(SRC)/. $(DIST)/$(DIST_NAME)/
	@find $(DIST)/$(DIST_NAME) -name '*.ts' -not -name '*.d.ts' -delete
	@rm -rf $(DIST)/$(DIST_NAME)/types
	@echo "Dist created: $(DIST)/$(DIST_NAME)"

dist-history-stubs: build bump-version
	@mkdir -p $(DIST)/$(DIST_NAME).history-stubs
	@cp -a $(SRC)/. $(DIST)/$(DIST_NAME).history-stubs/
	@find $(DIST)/$(DIST_NAME).history-stubs -name '*.ts' -not -name '*.d.ts' -delete
	@rm -rf $(DIST)/$(DIST_NAME).history-stubs/types
	@for route in $(ROUTES); do \
		mkdir -p $(DIST)/$(DIST_NAME).history-stubs/$$route; \
		cp $(SRC)/index.html $(DIST)/$(DIST_NAME).history-stubs/$$route/index.html; \
	done
	@echo "Dist with history stubs created: $(DIST)/$(DIST_NAME).history-stubs"

lint:
	npx biome check .

lint-fix:
	npx biome check --write .

lint-format:
	npx biome format --write .

test: lint
	npx vitest run

test-watch: lint
	npx vitest

commit:
	npx cz

clean:
	@rm -rf $(DIST)
	@echo "Cleaned $(DIST)/"
