import { ComposerEditor } from "@openbot/ui/features/conversation/ComposerEditor";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";

function setup() {
  const onSubmit = vi.fn();
  const onQueue = vi.fn();
  render(() => (
    <ComposerEditor
      value="hello"
      placeholder="Message"
      ariaLabel="Message"
      disabled={false}
      onValueChange={() => {}}
      onSubmit={onSubmit}
      onQueue={onQueue}
      sendShortcut="enter"
      agentId={undefined}
      agents={[]}
    />
  ));
  return { editor: screen.getByRole("textbox", { name: "Message" }), onSubmit, onQueue };
}

it("queues the message on Cmd+Return", () => {
  const { editor, onSubmit, onQueue } = setup();
  fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
  expect(onQueue).toHaveBeenCalledTimes(1);
  expect(onSubmit).not.toHaveBeenCalled();
});

it("still sends on Return", () => {
  const { editor, onSubmit, onQueue } = setup();
  fireEvent.keyDown(editor, { key: "Enter" });
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onQueue).not.toHaveBeenCalled();
});
