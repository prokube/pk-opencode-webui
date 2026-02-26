# Contributing to opencode-web

Thanks for your interest in contributing!

## Development Setup

1. **Prerequisites**: [Bun](https://bun.sh), [OpenCode CLI](https://github.com/anomalyco/opencode)

2. **Fork and clone**:
   ```bash
   # Fork this repo on GitHub, then clone your fork
   git clone https://github.com/YOUR_USERNAME/opencode-web
   cd opencode-web/app-prefixable
   bun install
   ```

3. **Start development**:
   ```bash
   # Terminal 1: Start OpenCode server in your project directory
   cd /your/project
   opencode serve
   
   # Terminal 2: Start Web UI dev server
   cd opencode-web/app-prefixable
   bun run dev
   ```

4. **Open** http://localhost:3000

## Code Style

- TypeScript with strict mode
- Avoid `any` types where practical; prefer specific types
- Prefer `const` over `let`
- Early returns over nested if/else
- Single-word variable names where possible
- Rely on type inference; avoid explicit annotations unless necessary

## Base Path Handling

**Important**: Never hardcode paths in frontend code!

```typescript
// Correct - use prefix() from base-path context
import { useBasePath } from "../context/base-path";
const { prefix } = useBasePath();
fetch(prefix("/api/session"));

// Wrong - hardcoded path
fetch("/api/session");
```

## Pull Requests

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Test locally with different BASE_PATH values
5. Submit PR with clear description

## Testing with Different Prefixes

```bash
# Test with custom prefix
BASE_PATH=/myapp/ bun run dev
```

Then open http://localhost:3000/myapp/

## Issues

- Check existing issues before creating new ones
- Be specific about reproduction steps for bugs
- Include browser console errors when relevant

## Questions?

Open a discussion or issue.
