type RouteNavProps = {
  active?: "landing" | "cruise";
};

const links = [
  { href: "/", label: "Overview", route: "landing" },
  { href: "/cruise", label: "Cruise", route: "cruise" },
] as const;

export function RouteNav({ active }: RouteNavProps) {
  return (
    <nav className="route-nav" aria-label="Routes">
      {links.map((link) => (
        <a
          key={link.href}
          href={link.href}
          data-active={active === link.route ? "true" : "false"}
        >
          {link.label}
        </a>
      ))}
    </nav>
  );
}
