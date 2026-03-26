mod app;
mod event;
mod ralph;
mod ui;

use anyhow::Result;
use crossterm::event::KeyEventKind;
use crossterm::terminal::{self, EnterAlternateScreen, LeaveAlternateScreen};
use crossterm::ExecutableCommand;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use std::io;
use std::time::Duration;

use app::App;
use event::{AppEvent, EventHandler};

fn main() -> Result<()> {
    // Setup terminal
    terminal::enable_raw_mode()?;
    let mut stdout = io::stdout();
    stdout.execute(EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let app_result = run(&mut terminal);

    // Restore terminal
    terminal::disable_raw_mode()?;
    io::stdout().execute(LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    if let Err(e) = app_result {
        eprintln!("Error: {}", e);
    }

    Ok(())
}

fn run(terminal: &mut Terminal<CrosstermBackend<io::Stdout>>) -> Result<()> {
    let mut app = App::new();
    let events = EventHandler::new(Duration::from_millis(500));

    loop {
        terminal.draw(|frame| ui::render(frame, &mut app))?;

        match events.next()? {
            AppEvent::Key(key) => {
                // Only handle key press events (not release/repeat)
                if key.kind == KeyEventKind::Press {
                    app.handle_key(key);
                }
            }
            AppEvent::Tick => app.on_tick(),
        }

        if app.should_quit {
            break;
        }
    }

    Ok(())
}
