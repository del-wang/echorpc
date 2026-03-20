def hello(name: str) -> str:
    return f"Hello, {name}!"

def test_hello():
    assert hello("World",6666) == "Hello, World!"
    
if __name__ == "__main__":
    test_hello()