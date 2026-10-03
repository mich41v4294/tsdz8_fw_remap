from __future__ import annotations

import unittest
from unittest.mock import patch

from tools.jlink_flasher.cli import build_parser, interactive, main


class CliTests(unittest.TestCase):
    def test_flash_defaults(self) -> None:
        args = build_parser().parse_args(["flash", "a.hex"])
        self.assertFalse(args.power)
        self.assertEqual(args.device, "XMC1302-T038x0064")
        self.assertEqual(args.speed, 4000)

    def test_empty_argv_calls_interactive(self) -> None:
        with patch("tools.jlink_flasher.cli.interactive", return_value=0) as mock:
            self.assertEqual(main([]), 0)
            mock.assert_called_once_with()

    def test_subcommand_does_not_open_menu(self) -> None:
        with patch("tools.jlink_flasher.cli.interactive") as menu:
            with patch("tools.jlink_flasher.cli.cmd_info", return_value=0) as info:
                self.assertEqual(main(["info"]), 0)
                info.assert_called_once()
                menu.assert_not_called()

    def test_interactive_quit(self) -> None:
        with patch("builtins.input", return_value="5"):
            self.assertEqual(interactive(), 0)

    def test_interactive_eof(self) -> None:
        with patch("builtins.input", side_effect=EOFError):
            self.assertEqual(interactive(), 0)

    def test_interactive_flash_dispatches(self) -> None:
        with patch("builtins.input", side_effect=["3", "patched.hex", "n"]):
            with patch("tools.jlink_flasher.cli._run", return_value=0) as run:
                self.assertEqual(interactive(), 0)
                run.assert_called_once_with(["flash", "patched.hex"])

    def test_interactive_flash_power(self) -> None:
        with patch("builtins.input", side_effect=["3", "patched.hex", "y"]):
            with patch("tools.jlink_flasher.cli._run", return_value=0) as run:
                self.assertEqual(interactive(), 0)
                run.assert_called_once_with(["flash", "patched.hex", "--power"])


if __name__ == "__main__":
    unittest.main()
