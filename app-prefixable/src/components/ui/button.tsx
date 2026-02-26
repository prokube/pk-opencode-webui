import { type JSX, splitProps } from "solid-js"

interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger"
  size?: "sm" | "md" | "lg" | "small" | "normal" | "large"
}

/**
 * Button component styled like pkui dev-labs UI
 * - Primary: brand color background with white text
 * - Secondary/Ghost: white/transparent with brand hover
 * - Rounded corners
 */
export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ["variant", "size", "class", "children"])

  const baseClasses =
    "inline-flex items-center justify-center gap-2 font-medium rounded-xl border-2 transition-all focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"

  const variantClasses = {
    // Primary: brand bg, white text
    primary: "bg-brand-500 border-brand-500 text-white hover:bg-brand-600 hover:border-brand-600 hover:shadow-md",
    // Secondary: white bg, gray text, brand hover
    secondary:
      "bg-white border-gray-200 text-gray-900 hover:border-brand-500 hover:bg-brand-50 hover:text-brand-600 hover:shadow-md",
    // Ghost: transparent, brand hover
    ghost: "bg-transparent border-transparent text-gray-700 hover:bg-brand-50 hover:text-brand-600",
    // Danger: white bg, red text, red hover
    danger:
      "bg-white border-gray-200 text-red-600 hover:border-red-500 hover:bg-red-50 hover:text-red-700 hover:shadow-md",
  }

  const sizeClasses: Record<string, string> = {
    sm: "px-3 py-1.5 text-sm",
    small: "px-3 py-1.5 text-sm",
    md: "px-4 py-2 text-sm",
    normal: "px-4 py-2 text-sm",
    lg: "px-6 py-3 text-base",
    large: "px-6 py-3 text-base",
  }

  const variant = local.variant || "secondary"
  const size = local.size || "md"

  return (
    <button {...rest} class={`${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${local.class || ""}`}>
      {local.children}
    </button>
  )
}
