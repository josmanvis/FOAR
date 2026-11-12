state default
{
    state_entry()
    {
        llOwnerSay((string)("System Initialized"));
    }
    touch_start(integer total)
    {
        llOwnerSay((string)("Touched: " + total));
        state active;
    }
}

state active
{
    state_entry()
    {
        llOwnerSay((string)("Active State Entered"));
    }
    touch_start(integer total)
    {
        state default;
    }
}
