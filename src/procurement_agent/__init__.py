"""Procurement sourcing intelligence agent.

The package is organised around a demand-driven sourcing flow:

- demand (free text and/or PPTX) is the only required input;
- historical purchase data is optional and stays in a separate source namespace;
- every externally sourced fact must carry evidence;
- prices are typed and never silently mixed.
"""

__version__ = "0.1.0"
