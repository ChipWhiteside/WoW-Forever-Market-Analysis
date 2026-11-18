import { createContext, useContext } from 'react';
export interface Nav { go: (page: string) => void; openItem: (id: number) => void }
export const NavContext = createContext<Nav>({ go: () => {}, openItem: () => {} });
export const useNav = () => useContext(NavContext);
