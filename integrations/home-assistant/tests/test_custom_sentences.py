"""Verify the packaged Assist sentences are installed, upgraded, and preserve edits."""

from pathlib import Path
import shutil

from custom_components.meitheal import _install_custom_sentences

SOURCE = str(Path(__file__).parents[1] / "custom_components" / "meitheal" / "custom_sentences")


def test_sentence_files_are_installed_and_preserve_local_edits(tmp_path):
    src = tmp_path / "src"
    dst = tmp_path / "dst"
    shutil.copytree(SOURCE, src)

    assert _install_custom_sentences(str(src), str(dst)) is True
    installed = dst / "en" / "meitheal.yaml"
    original = installed.read_text()
    assert original.strip()
    assert _install_custom_sentences(str(src), str(dst)) is False

    # Packaged update refreshes an unmodified installed file.
    src_file = src / "en" / "meitheal.yaml"
    upgraded = f"{original}\n# packaged upgrade\n"
    src_file.write_text(upgraded)
    assert _install_custom_sentences(str(src), str(dst)) is True
    assert installed.read_text() == upgraded

    # User edits on disk are preserved even when the packaged copy changes again.
    installed.write_text("language: en\n# custom household override\n")
    src_file.write_text(f"{upgraded}# second upgrade\n")
    assert _install_custom_sentences(str(src), str(dst)) is False
    assert "# custom household override" in installed.read_text()

    assert _install_custom_sentences(str(tmp_path / "missing"), str(dst)) is False
