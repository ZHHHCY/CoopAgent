fn main() {
    #[cfg(debug_assertions)]
    {
        let args: Vec<_> = std::env::args().skip(1).collect();
        let result = if args.is_empty() { coopagent_lib::run_agent_test_stdio() }
            else if args == ["--desktop"] { coopagent_lib::run_agent_test_desktop() }
            else { Err("Only --desktop is accepted".into()) };
        if let Err(error) = result {
            eprintln!("Agent test interface: {error}");
            std::process::exit(1);
        }
    }
    #[cfg(not(debug_assertions))]
    {
        eprintln!("The Agent test interface is available in debug builds only.");
        std::process::exit(1);
    }
}
