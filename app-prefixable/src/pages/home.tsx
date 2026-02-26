import { useNavigate } from "@solidjs/router"
import { useSDK } from "../context/sdk"
import { base64Encode } from "../utils/path"
import { Plus, Settings } from "lucide-solid"
import { Button } from "../components/ui/button"

// OpenCode Wordmark (same as project-picker)
function OpenCodeWordmark(props: { class?: string }) {
  return (
    <svg class={props.class} viewBox="0 0 640 115" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M49.2346 82.1433H16.4141V49.2861H49.2346V82.1433Z" fill="#CFCECD" />
      <path
        d="M49.2308 32.8573H16.4103V82.143H49.2308V32.8573ZM65.641 98.5716H0V16.4287H65.641V98.5716Z"
        fill="#656363"
      />
      <path d="M131.281 82.1433H98.4609V49.2861H131.281V82.1433Z" fill="#CFCECD" />
      <path
        d="M98.4649 82.143H131.285V32.8573H98.4649V82.143ZM147.696 98.5716H98.4649V115H82.0547V16.4287H147.696V98.5716Z"
        fill="#656363"
      />
      <path d="M229.746 65.7139V82.1424H180.516V65.7139H229.746Z" fill="#CFCECD" />
      <path
        d="M229.743 65.7144H180.512V82.143H229.743V98.5716H164.102V16.4287H229.743V65.7144ZM180.512 49.2859H213.332V32.8573H180.512V49.2859Z"
        fill="#656363"
      />
      <path d="M295.383 98.5718H262.562V49.2861H295.383V98.5718Z" fill="#CFCECD" />
      <path
        d="M295.387 32.8573H262.567V98.5716H246.156V16.4287H295.387V32.8573ZM311.797 98.5716H295.387V32.8573H311.797V98.5716Z"
        fill="#656363"
      />
      <path d="M393.848 82.1433H344.617V49.2861H393.848V82.1433Z" fill="#CFCECD" />
      <path d="M393.844 32.8573H344.613V82.143H393.844V98.5716H328.203V16.4287H393.844V32.8573Z" fill="#211E1E" />
      <path d="M459.485 82.1433H426.664V49.2861H459.485V82.1433Z" fill="#CFCECD" />
      <path
        d="M459.489 32.8573H426.668V82.143H459.489V32.8573ZM475.899 98.5716H410.258V16.4287H475.899V98.5716Z"
        fill="#211E1E"
      />
      <path d="M541.539 82.1433H508.719V49.2861H541.539V82.1433Z" fill="#CFCECD" />
      <path
        d="M541.535 32.8571H508.715V82.1428H541.535V32.8571ZM557.946 98.5714H492.305V16.4286H541.535V0H557.946V98.5714Z"
        fill="#211E1E"
      />
      <path d="M639.996 65.7139V82.1424H590.766V65.7139H639.996Z" fill="#CFCECD" />
      <path
        d="M590.77 32.8573V49.2859H623.59V32.8573H590.77ZM640 65.7144H590.77V82.143H640V98.5716H574.359V16.4287H640V65.7144Z"
        fill="#211E1E"
      />
    </svg>
  )
}

export function Home() {
  const { client, directory } = useSDK()
  const navigate = useNavigate()

  async function createNewSession() {
    if (!directory) return
    try {
      const res = await client.session.create({})
      if (res.data) {
        const slug = base64Encode(directory)
        navigate(`/${slug}/session/${res.data.id}`)
      }
    } catch (e) {
      console.error("Failed to create session:", e)
    }
  }

  function openSettings() {
    if (!directory) return
    const slug = base64Encode(directory)
    navigate(`/${slug}/settings`)
  }

  return (
    <div class="mx-auto mt-40 w-full md:w-auto px-4 max-w-xl">
      {/* Logo */}
      <OpenCodeWordmark class="w-full md:w-xl opacity-12 mx-auto" />

      {/* Action buttons - stacked vertically like project-picker */}
      <div class="mt-8 flex flex-col gap-2">
        <Button variant="ghost" size="large" class="justify-start px-3" onClick={createNewSession}>
          <Plus class="w-5 h-5" />
          Start New Session
        </Button>
        <Button variant="ghost" size="large" class="justify-start px-3" onClick={openSettings}>
          <Settings class="w-5 h-5" />
          Settings
        </Button>
      </div>

      {/* Hint text */}
      <p class="mt-12 text-sm text-center" style={{ color: "var(--text-weak)" }}>
        Select a session from the sidebar or start a new conversation
      </p>
    </div>
  )
}
