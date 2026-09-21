import { icons, type LucideProps } from "lucide-react";

/** Renders a lucide icon by manifest name; unknown names fall back to a box. */
export function Icon({ name, ...props }: { name?: string } & LucideProps) {
  const Comp = (name && icons[name as keyof typeof icons]) || icons.Box;
  return <Comp size={17} strokeWidth={1.8} {...props} />;
}
