"""Verify the packaged Assist sentences are installed and refreshed."""

from pathlib import Path

from custom_components.meitheal import _install_custom_sentences

SOURCE = str(Path(__file__).parents[1] / "custom_components" / "meitheal" / "custom_sentences")


def test_sentence_files_are_installed_and_refreshed(tmp_path):
    assert _install_custom_sentences(SOURCE, str(tmp_path)) is True
    installed = tmp_path / "en" / "meitheal.yaml"
    assert installed.read_text().strip()
    assert _install_custom_sentences(SOURCE, str(tmp_path)) is False
    installed.write_text("language: en\n")
    assert _install_custom_sentences(SOURCE, str(tmp_path)) is True
    assert installed.read_text() != "language: en\n"
    assert _install_custom_sentences(str(tmp_path / "missing"), str(tmp_path)) is False
