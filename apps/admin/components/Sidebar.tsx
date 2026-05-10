export function Sidebar() {
  return (
    <aside className="w-56 shrink-0 border-r border-gray-200 bg-white">
      <nav aria-label="Main navigation">
        <ul className="py-2">
          <li>
            <a
              href="/"
              className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 rounded mx-1"
            >
              Home
            </a>
          </li>
        </ul>
      </nav>
    </aside>
  );
}
