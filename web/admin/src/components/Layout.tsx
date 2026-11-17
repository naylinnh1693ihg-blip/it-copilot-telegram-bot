import { NavLink, Outlet } from "react-router-dom";
import { useSession } from "../session";
import styles from "./Layout.module.css";

const LINKS = [
  { to: "/", label: "Home", end: true },
  { to: "/knowledge", label: "Knowledge", end: false },
  { to: "/memory", label: "Memory", end: false },
  { to: "/usage", label: "Usage", end: false },
  { to: "/settings", label: "Settings", end: false },
];

const FORM_LINKS = [
  { href: "/admin/equipment", label: "Equipment" },
  { href: "/admin/contacts", label: "Contacts" },
  { href: "/admin/links", label: "Links" },
];

export function Layout() {
  const session = useSession();
  const name = session.data?.user.displayName ?? "Owner";
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <span className={styles.brand}>IT Copilot</span>
        <span className={styles.who}>{name}</span>
      </header>
      <nav className={styles.nav} aria-label="Main">
        {LINKS.map((link) => (
          <NavLink key={link.to} to={link.to} end={link.end} className={({ isActive }) => (isActive ? `${styles.link} ${styles.active}` : styles.link)}>
            {link.label}
          </NavLink>
        ))}
        {FORM_LINKS.map((link) => (
          <a key={link.href} href={link.href} className={styles.link}>
            {link.label}
          </a>
        ))}
      </nav>
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
