import { NavLink, Outlet } from 'react-router';
import { buyerNav } from '../routes';

// Placeholder shell (SP-024a). SP-024b replaces this file; keep the default export and <Outlet />.
export default function BuyerShell() {
  return (
    <div className="flex min-h-screen bg-canvas">
      <nav aria-label="Buyer" className="w-56 shrink-0 border-r border-line bg-surface p-4">
        <p className="mb-4 font-semibold text-accent">Spigot for agents</p>
        <ul className="space-y-1">
          {buyerNav.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `block rounded-md px-3 py-2 text-sm ${isActive ? 'bg-accent-tint font-medium text-accent-strong' : 'text-body hover:bg-surface-2'}`
                }
              >
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
