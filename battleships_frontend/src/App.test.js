import { render, screen } from "@testing-library/react";
import App from "./App";

test("renders Battleships title", () => {
  render(<App />);
  const title = screen.getByText(/Battleships/i);
  expect(title).toBeInTheDocument();
});
