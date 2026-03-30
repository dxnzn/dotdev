DXKIT_ROOT := ../dxkit
SRC := src
DIST := dist
SITE := _site
VERSION_FILE := BUILD_VERSION

DATE := $(shell date +%Y%m%d)
ITER := $(shell cat $(VERSION_FILE))
DIST_NAME := dnzn.dev-$(DATE).$(ITER)

# Routes for history-mode stubs (keep in sync with dapp manifests)
ROUTES := about projects support tools/cic tools/tpl

.PHONY: vendor serve build watch setup dist dist-history-stubs clean bump-version lint lint-fix lint-format test test-watch commit prepare-site deploy

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

prepare-site: build
	@rm -rf $(SITE)
	@mkdir -p $(SITE)
	@cp -a $(SRC)/. $(SITE)/
	@find $(SITE) -name '*.ts' -not -name '*.d.ts' -delete
	@rm -rf $(SITE)/types
	@touch $(SITE)/.nojekyll
	@echo "Site prepared in $(SITE)/"

deploy: vendor build test prepare-site
	@echo "Deploying to gh-pages..."
	@CURRENT_SHA=$$(git rev-parse --short HEAD) && \
	DEPLOY_MSG="Deploy from $$CURRENT_SHA on $$(date -u +%Y-%m-%dT%H:%M:%SZ)" && \
	TMPDIR=$$(mktemp -d) && \
	trap "rm -rf $$TMPDIR" EXIT && \
	if git rev-parse --verify gh-pages >/dev/null 2>&1; then \
		git worktree add --quiet "$$TMPDIR/worktree" gh-pages; \
	else \
		git worktree add --quiet --orphan -b gh-pages "$$TMPDIR/worktree"; \
	fi && \
	rm -rf "$$TMPDIR/worktree"/* && \
	cp -a $(SITE)/. "$$TMPDIR/worktree/" && \
	cd "$$TMPDIR/worktree" && \
	git add -A && \
	if git diff --cached --quiet; then \
		echo "No changes to deploy."; \
	else \
		git commit -m "$$DEPLOY_MSG" && \
		git push origin gh-pages --force && \
		echo "Deployed to gh-pages."; \
	fi && \
	cd - >/dev/null && \
	git worktree remove --force "$$TMPDIR/worktree"

clean:
	@rm -rf $(DIST)
	@echo "Cleaned $(DIST)/"
